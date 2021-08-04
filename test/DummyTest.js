// TODO: Remove
import { strictEqual } from 'assert';
describe('Array', function() {
  describe('#indexOf()', function() {
    it('should return -1 when the value is not present', function() {
        strictEqual([1, 2, 3].indexOf(4), -1);
    });
  });
});
