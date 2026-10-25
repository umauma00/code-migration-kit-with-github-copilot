public class Main : Ship.Billing.Base, Ship.Shipping.IFoo { }
public class Two : IBar, Ship.Orders.IBaz, Ship.Inv.IQ<int> where T : Ship.Cons.IC, new() { }
public record R(int X) : Ship.Rec.Base(X), Ship.Rec2.I;
class G<T> where T : Ship.Where.Base { void F(int a = 1) { var x = c ? d.e.f : g.h.i; F(a: x.y.z, k.l.m); } }
