import ICAL from 'ical.js';
import { ianaTimezone } from './windows-timezones.js';

const weekdays = { sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA' };
const indices = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };
const formatters = new Map();
function timezoneFormatter(zone) {
  if (!formatters.has(zone)) {
    if (formatters.size >= 256) formatters.delete(formatters.keys().next().value);
    formatters.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  }
  return formatters.get(zone);
}
const escaped = value => String(value || '').replace(/\\/g, '\\\\').replace(/\r\n|\n|\r/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const compact = value => String(value).replace(/[-:]/g, '').replace(/\.\d+(?=Z|$)/, '');
function wallDate(value, zone) {
  const date = new Date(value);
  if (!Number.isFinite(+date)) throw new Error('Calendar event contains an invalid date');
  const parts = Object.fromEntries(timezoneFormatter(zone).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
function graphRule(recurrence) {
  const { pattern: p = {}, range = {} } = recurrence || {};
  const frequency = { daily: 'DAILY', weekly: 'WEEKLY', absoluteMonthly: 'MONTHLY', relativeMonthly: 'MONTHLY', absoluteYearly: 'YEARLY', relativeYearly: 'YEARLY' }[p.type];
  if (!frequency) throw new Error('Unsupported Microsoft recurrence pattern');
  const interval = p.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 10000) throw new Error('Invalid Microsoft recurrence interval');
  const parts = [`FREQ=${frequency}`, `INTERVAL=${interval}`];
  if (p.type === 'weekly' || p.type.startsWith('relative')) {
    const days = [...new Set((p.daysOfWeek || []).map(day => weekdays[String(day).toLowerCase()]))];
    if (!days.length || days.some(day => !day)) throw new Error('Invalid Microsoft recurrence weekdays');
    parts.push(`BYDAY=${days.join(',')}`);
    if (p.type !== 'weekly') {
      const index = indices[String(p.index || 'first').toLowerCase()];
      if (!index) throw new Error('Invalid Microsoft recurrence index');
      parts.push(`BYSETPOS=${index}`);
    } else parts.push(`WKST=${weekdays[String(p.firstDayOfWeek || 'sunday').toLowerCase()] || 'SU'}`);
  }
  if (p.type.startsWith('absolute')) {
    if (!Number.isInteger(p.dayOfMonth) || p.dayOfMonth < 1 || p.dayOfMonth > 31) throw new Error('Invalid Microsoft recurrence day');
    // Iterate one month endpoint, then clamp to the requested day during
    // expansion. This preserves Exchange's short-month substitution without
    // relying on ical.js BYMONTHDAY/BYSETPOS combinations it cannot expand.
    parts.push('BYMONTHDAY=-1');
  }
  if (p.type.endsWith('Yearly')) {
    if (!Number.isInteger(p.month) || p.month < 1 || p.month > 12) throw new Error('Invalid Microsoft recurrence month');
    parts.push(`BYMONTH=${p.month}`);
  }
  if (range.type === 'numbered') {
    if (!Number.isInteger(range.numberOfOccurrences) || range.numberOfOccurrences < 1) throw new Error('Invalid Microsoft recurrence count');
    parts.push(`COUNT=${range.numberOfOccurrences}`);
  }
  return parts.join(';');
}

/** Convert normalized Graph, Google or local event recurrence to a scoped VEVENT. */
export function providerCalendar(event) {
  if (event.calendarComponent) return event;
  const recurrence = event.recurrence, graph = event.provider === 'microsoft' && recurrence?.pattern;
  const zone = ianaTimezone(graph ? recurrence.range?.recurrenceTimeZone || event.timezone || 'UTC' : event.timezone || 'UTC');
  const startDate = event.startDate || event.providerRaw?.start?.date;
  const endDate = event.endDate || event.providerRaw?.end?.date;
  let start = event.allDay ? startDate || wallDate(event.start, zone).slice(0, 10) : wallDate(event.start, zone);
  let end = event.allDay ? endDate || wallDate(event.end, zone).slice(0, 10) : wallDate(event.end, zone);
  let recurrenceLines = [];
  if (graph) {
    const rule = graphRule(recurrence);
    const firstRule = ICAL.Recur.fromString(rule.replace(/;INTERVAL=\d+/, ';INTERVAL=1').replace(/;COUNT=\d+/, ''));
    const anchor = ICAL.Time.fromString(start);
    const iterator = firstRule.iterator(anchor);
    let first = iterator.next();
    if (first && recurrence.pattern.type.startsWith('absolute')) {
      const actual = first.clone(); actual.day = Math.min(recurrence.pattern.dayOfMonth, first.day);
      if (actual.compare(anchor) < 0) first = iterator.next();
    }
    if (!first) throw new Error('Microsoft recurrence has no first occurrence');
    const duration = ICAL.Time.fromString(end).subtractDate(anchor), finish = first.clone(); finish.addDuration(duration);
    start = first.toString(); end = finish.toString();
    recurrenceLines = ['RRULE:' + rule];
  } else if (Array.isArray(recurrence) && recurrence.length) {
    if (recurrence.length > 100 || recurrence.some(line => typeof line !== 'string' || line.length > 65536 || /[\r\n\0]/.test(line) || !/^(RRULE|RDATE|EXDATE)(;[^:]*)?:/i.test(line))) throw new Error('Unsupported provider recurrence content');
    recurrenceLines = recurrence.map(line => line.replace(/TZID=([^;:]+)/gi, (_, name) => 'TZID=' + ianaTimezone(name)));
  } else if (event.repeat && event.repeat !== 'none') recurrenceLines = [`RRULE:FREQ=${String(event.repeat).toUpperCase()}${event.until ? `;UNTIL=${compact(event.until)}${event.allDay ? '' : 'T235959'}` : ''}`];
  const properties = ['BEGIN:VEVENT', `UID:${escaped(event.iCalUID || event.calendarUid || event.providerId || event.id || 'local')}`, `SUMMARY:${escaped(event.title)}`, `DTSTART${event.allDay ? ';VALUE=DATE' : `;TZID=${zone}`}:${compact(start)}`, `DTEND${event.allDay ? ';VALUE=DATE' : `;TZID=${zone}`}:${compact(end)}`, ...recurrenceLines, 'END:VEVENT'];
  const component = properties.join('\r\n');
  // Parsing here also validates recurrence values before they reach expansion.
  new ICAL.Component(ICAL.parse(component));
  return { ...event, timezone: zone, calendarComponent: component, calendarTimezones: [], graphAbsoluteDay: graph && recurrence.pattern.type.startsWith('absolute') ? recurrence.pattern.dayOfMonth : null, recurrenceEndDate: graph && recurrence.range?.type === 'endDate' ? recurrence.range.endDate : null, exclusionDates: event.exclusionDates || [] };
}

function seriesKey(event, id = event.providerId || event.id) { return JSON.stringify([event.accountId || '', event.provider || '', event.collectionId || '', id || '']); }
function originalIdentity(event, master) {
  const original = event.originalStart || event.providerRaw?.originalStartTime;
  if (original?.date) return original.date;
  const date = typeof original === 'string' ? original : original?.dateTime;
  if (date) {
    const zone = ianaTimezone(original?.timeZone || master?.timezone || event.timezone || 'UTC');
    const instant = /(?:Z|[+-]\d{2}:\d{2})$/.test(date) ? new Date(date) : utc(ICAL.Time.fromString(date), zone, new Map());
    return master?.allDay ? wallDate(instant, zone).slice(0, 10) : instant.toISOString();
  }
  const day = String(event.occurrenceId || '').match(/\.(\d{4}-\d{2}-\d{2})$/)?.[1];
  if (!day) return null;
  if (master?.allDay) return day;
  const zone = ianaTimezone(master?.timezone || event.timezone || 'UTC'), time = wallDate(master.start, zone).slice(10);
  return utc(ICAL.Time.fromString(day + time), zone, new Map()).toISOString();
}

/** Expand a whole calendar while replacing generated occurrences with provider exceptions. */
export function calendarOccurrences(events, from, to, options) {
  const masters = new Map(events.filter(event => !event.seriesMasterId).map(event => [seriesKey(event), event]));
  const exceptions = new Map(), detached = [], errors = [];
  for (const event of events.filter(event => event.seriesMasterId)) {
    const key = seriesKey(event, event.seriesMasterId), master = masters.get(key);
    if (!master) { detached.push(event); continue; }
    try {
      const original = originalIdentity(event, master);
      if (!original) { errors.push({ eventId: event.id, message: 'Provider exception is missing its original occurrence identity' }); continue; }
      const rows = exceptions.get(key) || {};
      const prior = rows[original];
      if (!prior || Date.parse(event.providerUpdatedAt || 0) >= Date.parse(prior.providerUpdatedAt || 0)) rows[original] = { ...event, recurrenceId: original, cancelled: !!event.cancelled || !!event.deleted };
      exceptions.set(key, rows);
    } catch (error) { errors.push({ eventId: event.id, message: error.message }); }
  }
  const out = []; let truncated = false;
  for (const event of [...masters.values(), ...detached]) {
    if (event.deleted || event.cancelled) continue;
    try {
      const calendar = providerCalendar(event), merged = { ...calendar, recurrenceOverrides: { ...(calendar.recurrenceOverrides || {}), ...(exceptions.get(seriesKey(event)) || {}) } };
      const expanded = expandImportedCalendar(merged, from, to, options);
      out.push(...expanded); truncated ||= !!expanded.truncated;
    } catch (error) { errors.push({ eventId: event.id, message: error.message }); }
  }
  out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (truncated) Object.defineProperty(out, 'truncated', { value: true });
  if (errors.length) Object.defineProperty(out, 'errors', { value: errors });
  return out;
}

function utc(time, timezone, zones) {
  if (time.isDate) return new Date(`${time.toString()}T00:00:00Z`);
  if (time.zone?.tzid === 'UTC') return time.toJSDate();
  if (zones.has(timezone)) { const value = time.clone(); value.zone = zones.get(timezone); return value.toJSDate(); }
  if (!timezone || timezone === 'UTC' || timezone === 'floating') return new Date(time.toString().replace(/Z$/, '') + 'Z');
  const format = timezoneFormatter(timezone);
  const target = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  let value = target;
  for (let pass = 0; pass < 4; pass++) {
    const p = Object.fromEntries(format.formatToParts(new Date(value)).filter(p => p.type !== 'literal').map(p => [p.type, +p.value]));
    const delta = target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (!delta) return new Date(value);
    value += delta;
  }
  throw new Error('Invalid calendar timezone transition');
}

function installTimezones(component, zones) {
  for (const property of component.getAllProperties()) {
    const tzid = property.getParameter('tzid');
    if (!tzid) continue;
    if (!zones.has(tzid)) {
      const name = ianaTimezone(tzid), zone = new ICAL.Timezone({ tzid });
      if (name === 'UTC') zones.set(tzid, ICAL.Timezone.utcTimezone);
      else { zone.utcOffset = time => (Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second) - +utc(time, name, new Map())) / 1000; zones.set(tzid, zone); }
    }
    for (const value of property.getValues()) if (value instanceof ICAL.Time) value.zone = zones.get(tzid);
  }
}

/** Bounded RFC 5545 recurrence expansion, including imported detached instances. */
export function expandImportedCalendar(event, from, to, { max = 1000, maxSteps = 10000 } = {}) {
  const out = [], lower = new Date(from), upper = new Date(to);
  if (event.cancelled || !event.calendarComponent || !(upper > lower)) return out;
  if (!Number.isInteger(max) || max < 1 || max > 10000 || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100000) throw new Error('Invalid calendar expansion limit');
  const root = new ICAL.Component(['vcalendar', [['version', {}, 'text', '2.0']], []]), zones = new Map();
  for (const source of event.calendarTimezones || []) {
    const zone = new ICAL.Component(ICAL.parse(source));
    root.addSubcomponent(zone);
    const tzid = zone.getFirstPropertyValue('tzid'); zones.set(tzid, new ICAL.Timezone({ component: zone, tzid }));
  }
  const component = new ICAL.Component(ICAL.parse(event.calendarComponent)); root.addSubcomponent(component);
  installTimezones(component, zones);
  const calendarEvent = new ICAL.Event(component);
  if (!calendarEvent.startDate) return out;
  const zone = component.getFirstProperty('dtstart')?.getParameter('tzid') || event.timezone || 'UTC';
  const overrides = Object.entries(event.recurrenceOverrides || {}).sort(([a], [b]) => a.localeCompare(b));
  const used = new Set(), expansion = calendarEvent.iterator();
  let steps = 0, finished = false;
  const append = (data, start, end, recurrenceId, occurrence) => {
    if (!data.cancelled && data.status !== 'cancelled' && end > lower && start < upper) out.push({ ...event, ...data, start: start.toISOString(), end: end.toISOString(), recurrenceId, occurrence });
  };
  for (; steps < maxSteps; steps++) {
    let next = expansion.next();
    if (!next) { finished = true; break; }
    if (event.graphAbsoluteDay) { next = next.clone(); next.day = Math.min(event.graphAbsoluteDay, next.day); }
    let start = utc(next, zone, zones);
    const originalStart = start;
    const endTime = next.clone(); endTime.addDuration(calendarEvent.duration);
    let end = utc(endTime, zone, zones);
    const recurrenceId = next.isDate ? next.toString() : start.toISOString();
    const occurrenceDay = next.toString().slice(0, 10);
    if (event.recurrenceEndDate && occurrenceDay > event.recurrenceEndDate) { finished = true; break; }
    if ((event.exclusionDates || []).includes(occurrenceDay)) continue;
    let override = event.recurrenceOverrides?.[recurrenceId];
    if (override) {
      used.add(recurrenceId);
      if (override.cancelled) { if (originalStart >= upper) { finished = true; break; } continue; }
      start = new Date(override.start); end = new Date(override.end);
    } else {
      const range = overrides.filter(([key, value]) => value.range === 'THISANDFUTURE' && key <= recurrenceId).at(-1);
      if (range) {
        override = range[1];
        if (override.cancelled) { if (originalStart >= upper) { finished = true; break; } continue; }
        if (override.startValue?.value && override.recurrenceValue?.value && override.startValue.timezone === override.recurrenceValue.timezone) {
          const shift = ICAL.Time.fromString(override.startValue.value).subtractDate(ICAL.Time.fromString(override.recurrenceValue.value));
          const shifted = next.clone(); shifted.addDuration(shift);
          start = utc(shifted, override.startValue.timezone, zones);
          const finish = shifted.clone(); finish.addDuration(ICAL.Duration.fromSeconds((Date.parse(override.end) - Date.parse(override.start)) / 1000));
          end = utc(finish, override.startValue.timezone, zones);
        } else {
          start = new Date(+start + Date.parse(override.start) - Date.parse(range[0]));
          end = new Date(+start + Date.parse(override.end) - Date.parse(override.start));
        }
      }
    }
    append(override || {}, start, end, recurrenceId, steps);
    if (out.length >= max) break;
    // Moved exceptions are added separately below, including those moved into the window.
    if (originalStart >= upper && start >= upper) { finished = true; break; }
    if (!calendarEvent.isRecurring()) { finished = true; break; }
  }
  for (const [key, override] of overrides) if (!used.has(key) && override.range !== 'THISANDFUTURE' && override.start && override.end) {
    append(override, new Date(override.start), new Date(override.end), key, key);
    if (out.length >= max) break;
  }
  out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const result = out.slice(0, max);
  if (!finished && (steps >= maxSteps || out.length >= max)) Object.defineProperty(result, 'truncated', { value: true, enumerable: false });
  return result;
}
