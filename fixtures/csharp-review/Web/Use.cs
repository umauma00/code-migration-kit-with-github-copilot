// Helper is declared in A and B: both ProjectReferences count, whatever the
// attribute order. [Acme.Validation.Required] names RequiredAttribute.
// using Models; inside namespace Acme.Web means Acme.Models.
[assembly: Acme.Validation.Required]
namespace Acme.Web
{
    using Models;
    class Use
    {
        Shared.Helper helper;
        [Acme.Validation.Required] int x;
        Order order;
        Entity entity;
    }
}
