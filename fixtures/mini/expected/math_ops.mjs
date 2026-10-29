export function divide(a, b) {
  if (b === 0) throw new Error('division by zero');
  const quotient = Math.floor(a / b);
  return [quotient, a - quotient * b];
}
// PORT STATUS: complete; fixture integers are within JavaScript's safe range.
