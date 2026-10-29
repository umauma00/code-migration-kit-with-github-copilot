// Attribute lists on parameters, type parameters and lambdas, before #if.
namespace N4 {
    class Decl<[Foo] T> {
        void M([Foo] int x, [Foo] ref int y) { var f = ([Foo] () => 1); }
        [Foo]
#if DEBUG
        void D() { }
#endif
    }
}
