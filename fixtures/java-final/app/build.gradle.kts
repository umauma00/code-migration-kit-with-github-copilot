dependencies {
    // Kotlin DSL named argument.
    implementation(project(path = ":core"))
    // Type-safe accessor: my-lib becomes myLib.
    implementation(projects.myLib)
}
