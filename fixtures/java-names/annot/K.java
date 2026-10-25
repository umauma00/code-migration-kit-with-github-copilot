package annot;
public enum K {
  @annot.mark.Mark A,
  @Ann B,
  @annot.mark.Mark(1) C,
  @Ann(Order.class) Customer,
  @annot . mark . Mark D(Customer),
  Order;
}
