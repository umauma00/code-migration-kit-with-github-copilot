using System.Collections.Generic;

namespace Shop.Data.Repos
{
    public class OrderRepository
    {
        public T First<T>(IList<T> items) where T : class => items[0];
        public Order Load() => Data.Legacy.Wrap(new Order());
    }
}
