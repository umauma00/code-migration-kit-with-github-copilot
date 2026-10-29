// T means N.R: T.Factory is N.R.Factory, not N.N.R.Factory.
namespace N {
    using T = R;
    class Main { void M() { var x = T.Factory.Create(); } }
}
