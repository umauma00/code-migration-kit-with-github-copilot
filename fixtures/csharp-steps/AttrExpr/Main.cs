// Collection expressions and initializer indexes, not attributes.
namespace N4 {
    public class Main {
        public Foo Foo = new Foo();
        void Consume(object[] xs) { }
        void Pair(object[] a, object[] b) { }
        void M() {
            Consume([Foo]);
            Pair([Foo], [Foo]);
            var list = new System.Collections.Generic.List<object[]> { [Foo] };
            var map = new System.Collections.Generic.Dictionary<object, int> { [Foo] = 1 };
            object[][] nested = [[Foo], [Foo]];
            var b = [Foo] is [];
        }
    }
}
