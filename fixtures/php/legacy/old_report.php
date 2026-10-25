<?php
class LegacyReport {
    const NAME = 'report';
    function render() {
        $db = new db();
        return <<<HTML
<div>new OrderService()</div>
HTML;
    }
}
