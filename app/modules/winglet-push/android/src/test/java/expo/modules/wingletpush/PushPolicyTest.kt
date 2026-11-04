package expo.modules.wingletpush
import org.junit.Assert.*
import org.junit.Test
class PushPolicyTest {
  @Test fun openAppSkipsRepliesApprovalsAndQuestions(){
    listOf("message","approval","question").forEach{ assertTrue(PushPolicy.skipWhileOpen(it,true)) }
  }
  @Test fun resultsStillNotifyWhileOpen(){ assertFalse(PushPolicy.skipWhileOpen("result",true)) }
  @Test fun nothingIsSkippedWhenTheAppIsNotConnected(){
    listOf("message","approval","question","result","test").forEach{ assertFalse(PushPolicy.skipWhileOpen(it,false)) }
  }
  @Test fun unknownKindsAreNeverSkipped(){ assertFalse(PushPolicy.skipWhileOpen("test",true)) }
}
