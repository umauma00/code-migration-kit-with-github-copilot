// Two namespace blocks in one file: each Thing resolves from its own block.
namespace A
{
    class First { Thing x; }
}

namespace B
{
    using Extra;

    class Second { Thing y; Helper h; }
}

namespace C
{
    // Extra is imported only inside namespace B, so Helper is not visible here.
    class Third { Helper h; }
}
