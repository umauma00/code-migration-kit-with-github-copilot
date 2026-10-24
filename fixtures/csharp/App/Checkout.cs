using Shop.Core;
using Shop.Core.Billing;

namespace Shop.App
{
    // Invoice, Receipt, InvoiceLine, Note, Stamp and Entry are never written here:
    // their files are reached through declared return and member types.
    public class Checkout : CheckoutBase
    {
        public void Run()
        {
            var invoice = Factory.CreateInvoice();
            var receipt = invoice.Pay();
            receipt.Print();
            foreach (var line in invoice.Lines)
            {
                line.Describe();
            }
            Audit().Seal();
            new Ledger()[0].Post();
        }
    }
}
