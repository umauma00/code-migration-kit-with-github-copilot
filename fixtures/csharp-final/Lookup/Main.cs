// using R inside N.Inner is searched before the outer namespace N, so
// Target is R.Target, not N.Target.
namespace N.Inner
{
    using R;
    class LookupMain { Target x; }
}
