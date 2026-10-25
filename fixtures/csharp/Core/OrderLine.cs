namespace Shop.Core
{
    public record OrderLine(Order Parent, decimal Price);
}
