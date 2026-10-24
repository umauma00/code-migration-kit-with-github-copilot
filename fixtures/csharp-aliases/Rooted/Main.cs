// using global::R; inside namespace N names R, not N.R.
namespace N { using global::R; class Main { Target x; } }
