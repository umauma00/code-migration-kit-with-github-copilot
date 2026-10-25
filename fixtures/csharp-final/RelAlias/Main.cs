// using T = R; inside namespace AN is AN.R, as a using would be (not the
// R.Target of Lookup/Real.cs).
namespace AN
{
    using T = R;
    class AliasMain { T.Target x; }
}
