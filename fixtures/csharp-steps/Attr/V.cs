// [Foo] may be Foo or FooAttribute; the compiler tries both, so both count.
using Lib;
namespace N2 { [Foo] class V { } }
