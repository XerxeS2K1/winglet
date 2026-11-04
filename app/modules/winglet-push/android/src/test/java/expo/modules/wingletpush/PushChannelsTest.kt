package expo.modules.wingletpush
import org.junit.Assert.*
import org.junit.Test
class PushChannelsTest {
  @Test fun approvalsAndQuestionsNeedYou(){
    assertEquals(PushChannels.NEEDS_YOU,PushChannels.forKind("approval"))
    assertEquals(PushChannels.NEEDS_YOU,PushChannels.forKind("question"))
  }
  @Test fun resultsAreRoutine(){ assertEquals(PushChannels.ROUTINE,PushChannels.forKind("result")) }
  @Test fun repliesAndEverythingElseAreReplies(){
    listOf("message","test","","something-new").forEach{ assertEquals(PushChannels.REPLIES,PushChannels.forKind(it)) }
  }
  @Test fun newIdsDifferFromTheOldChannel(){
    assertEquals(3,setOf(PushChannels.NEEDS_YOU,PushChannels.REPLIES,PushChannels.ROUTINE).size)
    assertFalse(setOf(PushChannels.NEEDS_YOU,PushChannels.REPLIES,PushChannels.ROUTINE).contains(PushChannels.LEGACY))
  }
}
