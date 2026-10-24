// An alias to global::R.Target names R.Target, not N.R.Target.
namespace N { using T = global::R.Target; class Other { T y; } }
