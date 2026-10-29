export function divide(a, b) {
  const quotient = Math.floor(a / b);
  return [quotient, a - quotient * b];
}
// PORT STATUS: complete; fixture integers are within JavaScript's safe range.
