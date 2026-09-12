import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarOccurrences, providerCalendar, expandImportedCalendar } from '../public/calendar-recurrence.js';
import { ianaTimezone, windowsTimezones } from '../public/windows-timezones.js';
import { normalizeEvent } from '../backend/providers/pim.js';

const graph = (pattern, range = {}, values = {}) => ({ ...normalizeEvent('microsoft', {
  id: 'master', subject: 'Recurring meeting', type: 'seriesMaster', start: { dateTime: '2026-09-14T12:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-14T13:00:00', timeZone: 'UTC' },
  originalStartTimeZone: 'Central European Standard Time', recurrence: { pattern, range: { type: 'numbered', numberOfOccurrences: 4, startDate: '2026-09-14', recurrenceTimeZone: 'Central European Standard Time', ...range } }, ...values,
}, { id: 'calendar-1' }), provider: 'microsoft', accountId: 'account-1', id: 'local-master' });
const dates = events => events.map(event => event.start);

test('CLDR maps Windows timezone identities and rejects unknown identifiers', () => {
  assert.equal(Object.keys(windowsTimezones).length, 139);
  assert.equal(ianaTimezone('Pacific Standard Time'), 'America/Los_Angeles');
  assert.equal(ianaTimezone('Central European Standard Time'), 'Europe/Warsaw');
  assert.equal(ianaTimezone('Europe/Paris'), 'Europe/Paris');
  assert.throws(() => ianaTimezone('Unknown standard time'), /Unknown calendar timezone/);
});

test('Graph weekly recurrence applies multiple weekdays, interval, week start and count', () => {
  const master = graph({ type: 'weekly', interval: 2, daysOfWeek: ['monday', 'tuesday'], firstDayOfWeek: 'monday' });
  assert.deepEqual(dates(calendarOccurrences([master], '2026-09-01', '2026-11-01')), ['2026-09-14T12:00:00.000Z', '2026-09-15T12:00:00.000Z', '2026-09-28T12:00:00.000Z', '2026-09-29T12:00:00.000Z']);
});

test('Graph daily and relative monthly ranges obey their local inclusive end dates', () => {
  const daily = graph({ type: 'daily', interval: 3 }, { type: 'endDate', endDate: '2026-09-20' });
  assert.deepEqual(dates(calendarOccurrences([daily], '2026-09-01', '2026-10-01')), ['2026-09-14T12:00:00.000Z', '2026-09-17T12:00:00.000Z', '2026-09-20T12:00:00.000Z']);
  const monthly = graph({ type: 'relativeMonthly', interval: 1, daysOfWeek: ['wednesday'], index: 'second' }, { type: 'endDate', endDate: '2026-11-30' });
  assert.deepEqual(dates(calendarOccurrences([monthly], '2026-09-01', '2026-12-01')), ['2026-10-14T12:00:00.000Z', '2026-11-11T13:00:00.000Z']);
});

test('Graph absolute monthly and yearly patterns substitute the last day for short months', () => {
  const monthly = graph({ type: 'absoluteMonthly', interval: 1, dayOfMonth: 31 }, { numberOfOccurrences: 3 }, { start: { dateTime: '2026-01-31T13:00:00' }, end: { dateTime: '2026-01-31T14:00:00' } });
  assert.deepEqual(dates(calendarOccurrences([monthly], '2026-01-01', '2026-05-01')), ['2026-01-31T13:00:00.000Z', '2026-02-28T13:00:00.000Z', '2026-03-31T12:00:00.000Z']);
  const yearly = graph({ type: 'absoluteYearly', interval: 1, month: 2, dayOfMonth: 29 }, { numberOfOccurrences: 3 }, { start: { dateTime: '2026-02-01T13:00:00' }, end: { dateTime: '2026-02-01T14:00:00' } });
  assert.deepEqual(dates(calendarOccurrences([yearly], '2026-01-01', '2029-01-01')), ['2026-02-28T13:00:00.000Z', '2027-02-28T13:00:00.000Z', '2028-02-29T13:00:00.000Z']);
});

test('Graph relative yearly recurrence chooses the last selected weekday in the selected month', () => {
  const master = graph({ type: 'relativeYearly', interval: 1, month: 11, daysOfWeek: ['wednesday'], index: 'last' }, { numberOfOccurrences: 2 });
  assert.deepEqual(dates(calendarOccurrences([master], '2026-01-01', '2028-01-01')), ['2026-11-25T13:00:00.000Z', '2027-11-24T13:00:00.000Z']);
});

test('Graph recurrence preserves local hour across DST and omits cancelled occurrence dates', () => {
  const master = graph({ type: 'weekly', interval: 1, daysOfWeek: ['sunday'] }, {}, { start: { dateTime: '2026-10-18T12:00:00' }, end: { dateTime: '2026-10-18T13:00:00' }, cancelledOccurrences: ['OID.master.2026-11-01'] });
  assert.deepEqual(dates(calendarOccurrences([master], '2026-10-01', '2026-12-01')), ['2026-10-18T12:00:00.000Z', '2026-10-25T13:00:00.000Z', '2026-11-08T13:00:00.000Z']);
});

test('Google RRULE, UTC EXDATE and RDATE match timezone-aware instances', () => {
  const master = { ...normalizeEvent('google', { id: 'google-master', summary: 'Google recurrence', start: { dateTime: '2026-10-18T14:00:00+02:00', timeZone: 'Europe/Warsaw' }, end: { dateTime: '2026-10-18T15:00:00+02:00', timeZone: 'Europe/Warsaw' }, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE:20261025T130000Z', 'RDATE:20261105T130000Z'] }, { id: 'primary' }), id: 'google-local', provider: 'google', accountId: 'google-account' };
  assert.deepEqual(dates(calendarOccurrences([master], '2026-10-01', '2026-12-01')), ['2026-10-18T12:00:00.000Z', '2026-11-01T13:00:00.000Z', '2026-11-05T13:00:00.000Z']);
});

test('provider exception records replace their base occurrence and preserve editable record identity', () => {
  const master = graph({ type: 'weekly', interval: 1, daysOfWeek: ['monday'] });
  const exception = { ...master, id: 'exception-local', providerId: 'exception-remote', seriesMasterId: 'master', eventType: 'exception', recurrence: null, repeat: 'none', originalStart: '2026-09-21T12:00:00Z', start: '2026-09-22T15:00:00Z', end: '2026-09-22T16:00:00Z', title: 'Moved meeting' };
  const cancellation = { ...exception, id: 'cancelled-local', providerId: 'cancelled-remote', originalStart: '2026-09-28T12:00:00Z', start: null, end: null, cancelled: true };
  const occurrences = calendarOccurrences([master, exception, cancellation], '2026-09-01', '2026-10-01');
  assert.deepEqual(dates(occurrences), ['2026-09-14T12:00:00.000Z', '2026-09-22T15:00:00.000Z']);
  assert.equal(occurrences[1].id, 'exception-local');
  assert.equal(occurrences[1].title, 'Moved meeting');
});

test('Graph occurrence IDs can identify exceptions without originalStart', () => {
  const master = graph({ type: 'weekly', interval: 1, daysOfWeek: ['monday'] });
  const exception = { ...master, id: 'cancelled-local', providerId: 'cancelled-remote', seriesMasterId: 'master', eventType: 'exception', originalStart: null, occurrenceId: 'OID.master.2026-09-21', start: null, end: null, cancelled: true };
  assert.deepEqual(dates(calendarOccurrences([master, exception], '2026-09-01', '2026-09-28')), ['2026-09-14T12:00:00.000Z']);
});

test('all-day Google exceptions use original calendar dates and never duplicate the master', () => {
  const master = { ...normalizeEvent('google', { id: 'all-day', summary: 'Days', start: { date: '2026-09-14', timeZone: 'Europe/Warsaw' }, end: { date: '2026-09-15', timeZone: 'Europe/Warsaw' }, recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] }, { id: 'primary', timezone: 'Europe/Warsaw' }), id: 'local-day', provider: 'google', accountId: 'a' };
  const cancelled = { ...normalizeEvent('google', { id: 'cancelled-day', recurringEventId: 'all-day', originalStartTime: { date: '2026-09-15' }, status: 'cancelled' }, { id: 'primary', timezone: 'Europe/Warsaw' }), id: 'cancel-day', provider: 'google', accountId: 'a' };
  assert.deepEqual(dates(calendarOccurrences([master, cancelled], '2026-09-01', '2026-10-01')), ['2026-09-14T00:00:00.000Z', '2026-09-16T00:00:00.000Z']);
});

test('exceptions cannot affect a series belonging to another account or calendar', () => {
  const master = graph({ type: 'daily', interval: 1 });
  const other = { ...master, id: 'other-calendar', accountId: 'different', cancelled: true, seriesMasterId: 'master', originalStart: '2026-09-14T12:00:00Z' };
  assert.equal(calendarOccurrences([master, other], '2026-09-01', '2026-10-01').length, 4);
});

test('invalid recurrence is reported while other events remain visible', () => {
  const invalid = graph({ type: 'unknown', interval: 1 });
  const valid = { id: 'native', title: 'Local event', start: '2026-09-14T12:00:00Z', end: '2026-09-14T13:00:00Z', timezone: 'UTC', repeat: 'none' };
  const result = calendarOccurrences([invalid, valid], '2026-09-01', '2026-10-01');
  assert.equal(result.length, 1); assert.equal(result.errors.length, 1);
  assert.throws(() => providerCalendar({ ...valid, provider: 'google', recurrence: ['RRULE:FREQ=DAILY\r\nATTENDEE:mailto:x@example.com'] }), /Unsupported provider recurrence/);
});

test('provider recurrence conversion can be called directly and expansion exposes its limits', () => {
  const event = providerCalendar(graph({ type: 'daily', interval: 1 }, { type: 'noEnd' }));
  assert.match(event.calendarComponent, /RRULE:FREQ=DAILY/);
  const result = expandImportedCalendar(event, '2026-09-01', '2030-01-01', { max: 2 });
  assert.equal(result.length, 2); assert.equal(result.truncated, true);
});
