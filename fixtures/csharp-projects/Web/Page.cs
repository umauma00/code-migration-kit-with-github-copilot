using Shop.Model;

namespace Shop.Web
{
    // Customer is declared in Core (referenced) and in Old (not referenced):
    // only Core's file is an edge. Helper is declared twice in this project,
    // but Legacy/ is removed from the build.
    public class Page
    {
        public Customer Owner { get; } = new Customer();
        public Helper Help() => new Helper();
    }
}
