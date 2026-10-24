namespace Shop.Data
{
    public class Legacy
    {
        public static Shop.Core.Order Wrap(Shop.Core.Order o) { Formatter.Format(1); return o; }
    }

    public delegate void LegacyHandler(int code);
}
