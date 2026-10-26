export function greeting(name) {
  return ['Hello, ' + name, [...name].length];
}
// PORT STATUS: complete; count Unicode code points, including astral characters.
