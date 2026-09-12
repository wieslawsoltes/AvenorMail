import js from '@eslint/js';
import globals from 'globals';
export default [js.configs.recommended,{ignores:['pages/**','node_modules/**']},{languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{...globals.browser,...globals.node,GPUBufferUsage:'readonly',GPUTextureUsage:'readonly',GPUShaderStage:'readonly'}},rules:{'no-unused-vars':['warn',{argsIgnorePattern:'^_',caughtErrors:'none'}],'no-empty':['error',{allowEmptyCatch:true}]}}];
