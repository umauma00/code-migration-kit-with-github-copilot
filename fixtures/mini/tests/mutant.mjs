// Deliberately broken port: truncation and UTF-16 length differ from Python.
import fs from 'node:fs';
const { a, b, name } = JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify(b === 0 ? { error: 'division by zero' } : {
  quotient: Math.trunc(a / b), remainder: a % b,
  greeting: 'Hello, ' + name, length: name.length
}));
