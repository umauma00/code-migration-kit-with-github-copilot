// The using after a file-scoped namespace also applies to type flow:
// Factory is FN.R.Factory, and its return type Model is an edge.
namespace FN;
using FN.R;
class FlowMain { void Run() { var x = Factory.Create(); } }
