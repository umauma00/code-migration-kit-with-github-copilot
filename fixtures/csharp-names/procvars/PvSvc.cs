namespace Pvc {
  // The parameter PvOrder of A is not in view in B: PvOrder.Create() there
  // is the class, and its PvInvoice is reached.
  public class PvSvc {
    public void A(string PvOrder) { }
    public decimal B() { return PvOrder.Create().Total; }
  }
}
