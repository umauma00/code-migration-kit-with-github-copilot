// An alias applies inside the namespace blocks nested in its block.
namespace Outer
{
    using T = A;
    namespace Inner { class R { T.Thing c; } }
}
