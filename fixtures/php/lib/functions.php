<?php
function format_price($amount) {
    return number_format($amount, 2) . ' ' . APP_VERSION;
}
