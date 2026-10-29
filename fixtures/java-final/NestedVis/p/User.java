package p;
import q.*;
// Util is q.Util (the on-demand import), not Outer's nested Util.
class User { void f() { Util.run(); } }
