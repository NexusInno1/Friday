const fs = require('fs');
const path = require('path');

const targetFiles = [
  'node_modules/@ai-sdk/google/dist/index.js',
  'node_modules/@ai-sdk/google/dist/index.mjs',
  'node_modules/@ai-sdk/google/internal/dist/index.js',
  'node_modules/@ai-sdk/google/internal/dist/index.mjs',
];

for (const relPath of targetFiles) {
  const fullPath = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(fullPath)) continue;

  let content = fs.readFileSync(fullPath, 'utf8');

  // 1. In contentSchema, allow thoughtSignature and thought_signature on the functionCall part schema
  // Look for z.object({ functionCall: z.object({ name: z.string(), args: z.unknown() }) })
  const schemaRegex = /(functionCall:\s*(\w+)\.object\(\{\s*name:\s*(\w+)\.string\(\),\s*args:\s*(\w+)\.unknown\(\)\s*\}\))/;
  if (schemaRegex.test(content) && !content.includes('thoughtSignature: z2.string().nullish()') && !content.includes('thoughtSignature: z.string().nullish()')) {
    const match = content.match(schemaRegex);
    const zVar = match[2];
    content = content.replace(
      schemaRegex,
      `$1,\n        thoughtSignature: ${zVar}.string().nullish(),\n        thought_signature: ${zVar}.string().nullish()`
    );
  }

  // 2. In getToolCallsFromParts: cache real signatures by toolCallId
  const getToolCallsRegex = /return functionCallParts == null \|\| functionCallParts\.length === 0 \? void 0 : functionCallParts\.map\(\(part\) => \{[\s\S]*?\}\);/;
  const isAltId = content.includes('generateId2()');
  const genIdCall = isAltId ? 'generateId2()' : 'generateId()';

  if (getToolCallsRegex.test(content)) {
    content = content.replace(
      getToolCallsRegex,
      `return functionCallParts == null || functionCallParts.length === 0 ? void 0 : functionCallParts.map((part) => {
    const id = ${genIdCall};
    const sig = part.thoughtSignature || part.thought_signature;
    if (sig) {
      if (!globalThis.__googleThoughtSignatures) globalThis.__googleThoughtSignatures = new Map();
      globalThis.__googleThoughtSignatures.set(id, sig);
    }
    return {
      toolCallType: "function",
      toolCallId: id,
      toolName: part.functionCall.name,
      args: JSON.stringify(part.functionCall.args),
      providerMetadata: {
        google: {
          thoughtSignature: sig
        }
      }
    };
  });`
    );
  }

  // 3. In case "tool-call": retrieve cached signature or fallback
  const toolCallCaseRegex = /case\s+"tool-call":\s*\{[\s\S]*?return\s*\{[\s\S]*?functionCall:\s*\{[\s\S]*?name:\s*part\.toolName,[\s\S]*?args:\s*part\.args[\s\S]*?\}[\s\S]*?\};?\s*\}/;
  if (toolCallCaseRegex.test(content)) {
    content = content.replace(
      toolCallCaseRegex,
      `case "tool-call": {
                const cachedSig = globalThis.__googleThoughtSignatures && globalThis.__googleThoughtSignatures.get(part.toolCallId);
                if (globalThis.__googleThoughtSignatures) {
                  globalThis.__googleThoughtSignatures.delete(part.toolCallId);
                }
                const thoughtSig = cachedSig || (part.providerMetadata && part.providerMetadata.google && part.providerMetadata.google.thoughtSignature) || "skip_thought_signature_validator";
                return {
                  functionCall: {
                    name: part.toolName,
                    args: part.args
                  },
                  thoughtSignature: thoughtSig
                };
              }`
    );
  }

  fs.writeFileSync(fullPath, content, 'utf8');
}
console.log('Patch complete.');
