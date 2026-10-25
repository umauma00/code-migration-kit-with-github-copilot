// The same alias in two namespace blocks names a different namespace in each.
namespace X { using T = A; class First { T.Thing a; } }
namespace Y { using T = B; class Second { T.Thing b; } }
