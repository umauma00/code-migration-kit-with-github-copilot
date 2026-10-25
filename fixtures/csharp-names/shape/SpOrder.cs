namespace Shp {
  // Members named like their types: each type written where only a type
  // stands is still a dependency (Customer? Customer, Wrapper<int> Wrapper).
  public class SpOrder {
    public SpCustomer? SpCustomer { get; set; }
    public SpStatus? SpStatus { get; set; }
    public SpWrapper<int> SpWrapper { get; set; }
    public (SpLine, int) SpLine { get; set; }
    public object SpTag { get; set; }
    public bool IsTag(object o) => o is not SpTag;
  }
}
