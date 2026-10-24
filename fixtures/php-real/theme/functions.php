<?php
// A back-compat copy behind a guard, as themes ship; it calls core.
if ( ! function_exists( 'wp_sep' ) ) :
	function wp_sep() { return ','; }
endif;
core_fn();
