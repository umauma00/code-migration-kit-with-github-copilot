package annot;
class Lists extends com.acme.lb.Base implements com.acme.li.IFoo, com.acme.li2.IBar {
  <T extends com.acme.gb.Cmp<T>, U> void f() throws com.acme.ex.Oops, com.acme.ex2.Oops2 { }
}
interface Two extends com.acme.ia.A, com.acme.ib.B { }
class Local extends Order implements annot.mark.Mark { }
