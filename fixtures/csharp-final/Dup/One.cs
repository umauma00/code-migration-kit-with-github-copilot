// Two non-partial classes with one name: the build fails or one copy is
// excluded somewhere the mapper cannot see. The copies are not linked to
// each other (that would be a false cycle); files that name it get both.
namespace D { class Dup { Dup next; } }
