// Two blocks of one namespace do not share their using directives.
namespace Z { using T = A; class P { T.Thing a; } }
namespace Z { using T = B; class Q { T.Thing b; } }
