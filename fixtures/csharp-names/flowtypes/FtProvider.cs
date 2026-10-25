namespace Flt {
  public interface IFtProvider { IFtUnit Get(); }
  // The new modifier: Get() here returns the scoped unit.
  public interface IFtScopeProvider : IFtProvider { new IFtScopeUnit Get(); }
}
