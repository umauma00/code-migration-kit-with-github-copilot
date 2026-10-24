// Both branches open one brace: still counted once.
namespace C
{
#if DEBUG
    public class X {
#else
    public class X : object {
#endif
        public int V;
    }
}

namespace D
{
    public class Z { }
}
