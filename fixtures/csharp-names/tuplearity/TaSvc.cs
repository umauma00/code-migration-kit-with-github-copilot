namespace Tar {
  // Result<(int Id, string Name)> has one type argument: a tuple.
  public class TaSvc { public TaResult Fail() => null; public TaResult<(int Id, string Name)> Create() => null; }
}
