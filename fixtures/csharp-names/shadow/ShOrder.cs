namespace Shd {
  // A field, a property and a method spelled like a type are not that type.
  public class ShOrder {
    private int ShStatus;
    public string ShCategory { get; set; }
    bool ShValidator() { return true; }
    public void Bump() { ShStatus++; if (ShStatus > 3 && ShCategory == "food" && ShValidator()) ShStatus = 0; }
  }
}
