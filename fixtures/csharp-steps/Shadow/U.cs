// using static A.Foo brings Foo's members and nested types, not the name
// Foo: Foo here is Z.Foo (A.cs stays an edge for the using static).
using Z;
namespace N { using static A.Foo; class U { Foo f; } }
