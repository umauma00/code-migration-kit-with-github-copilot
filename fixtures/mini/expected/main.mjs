import fs from 'node:fs';
import { divide } from './math_ops.mjs';
import { greeting } from './text_ops.mjs';
export function main(data) {
  try {
    const [quotient, remainder] = divide(data.a, data.b);
    const [message, length] = greeting(data.name);
    return { quotient, remainder, greeting: message, length };
  } catch (error) {
    return { error: error.message };
  }
}
console.log(JSON.stringify(main(JSON.parse(fs.readFileSync(0, 'utf8')))));
// PORT STATUS: complete for the fixture's documented input contract.
