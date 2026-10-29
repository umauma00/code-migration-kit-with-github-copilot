// B.Thing is never written here: it is Holder.Get's return type, written
// through Holder.cs's block alias.
namespace U
{
    class C
    {
        void M()
        {
            var h = new F.Holder();
            var x = h.Get();
        }
    }
}
