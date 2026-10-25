namespace Ar {
  // Result and Result<T> are different types, not copies of one.
  public class ArResult<T> : ArResult {
    public ArResult(T value) { }
    public T Value { get; private set; }
  }
}
