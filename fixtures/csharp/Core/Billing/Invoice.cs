using System.Collections.Generic;

namespace Shop.Core.Billing
{
    public class Invoice
    {
        public List<InvoiceLine> Lines { get; } = new List<InvoiceLine>();
        public Receipt Pay() => new Receipt();
    }
}
