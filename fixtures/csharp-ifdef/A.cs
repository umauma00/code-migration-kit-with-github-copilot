// The #if branches open a different number of braces; counting both would
// make B look like A.B.
namespace A
{
#if NET
    public class X {
#else
    public class X : object { public class Inner {
#endif
        public int V;
    }
}

namespace B
{
    public class Y { public const int V = 1; }
}
