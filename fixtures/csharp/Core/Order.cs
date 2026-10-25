using System.Collections.Generic;

namespace Shop.Core
{
    public partial class Order
    {
        public List<OrderLine> Lines { get; } = new();
    }
}
