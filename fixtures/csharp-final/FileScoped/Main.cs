// A using after a file-scoped namespace is inside it: R is F.R.
namespace F;
using R;
class FileScopedMain { Goal g; }
