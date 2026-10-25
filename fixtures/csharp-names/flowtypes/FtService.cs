namespace Flt {
  // var u = p.Get() through a new member, var i = b as IFtItem, and a cast.
  public class FtService {
    public IFtScopeProvider Provider { get; set; }
    public object A() { var u = Provider.Get(); return u.Events; }
    public object B(IFtBase b) { var i = b as IFtItem; return i.Key; }
    public object C(object o) { var t = (IFtTagged)Wrap(o); return t.Tag; }
    object Wrap(object o) => o;
  }
}
