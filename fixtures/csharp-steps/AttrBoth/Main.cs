// Attribute positions: [Foo], [return: Bar] and a parameter attribute.
namespace N3 { [Foo] class Main { [return: Bar] int M([Foo] int x) { return x; } } }
