using Shop.Core.Billing;

namespace Shop.App
{
    public abstract class CheckoutBase
    {
        protected Stamp Audit() => new Stamp();
    }
}
